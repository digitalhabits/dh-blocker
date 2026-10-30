//! Event-driven desktop activity gate. No periodic wakeups while suspended.
use std::sync::{Arc, Condvar, Mutex, Once, OnceLock};
use std::time::Duration;
use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    RegisterPowerSettingNotification, UnregisterPowerSettingNotification, POWERBROADCAST_SETTING,
};
use windows::Win32::System::RemoteDesktop::*;
use windows::Win32::System::SystemServices::GUID_SESSION_DISPLAY_STATUS;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::polling::Activity;

#[derive(Default)]
pub(super) struct Gate {
    state: Mutex<Activity>,
    changed: Condvar,
}

impl Gate {
    pub fn suspended(&self) -> bool {
        self.state.lock().unwrap().suspended()
    }

    // The timed wait is only used on an interactive desktop. Lock/display-off
    // notifications wake it early and replace it with an indefinite wait.
    pub fn wait_for_tick(&self, tick: Duration) {
        let mut state = self.state.lock().unwrap();
        loop {
            state = self
                .changed
                .wait_while(state, |state| state.suspended())
                .unwrap();
            let (next, timeout) = self.changed.wait_timeout(state, tick).unwrap();
            state = next;
            if timeout.timed_out() && !state.suspended() {
                return;
            }
        }
    }

    fn update(&self, update: impl FnOnce(&mut Activity)) {
        update(&mut self.state.lock().unwrap());
        self.changed.notify_all();
    }
}

static GATE: OnceLock<Arc<Gate>> = OnceLock::new();
static MONITOR: Once = Once::new();

pub(super) fn start() -> Arc<Gate> {
    let gate = GATE.get_or_init(|| Arc::new(Gate::default()));
    MONITOR.call_once(|| {
        let monitor = gate.clone();
        std::thread::spawn(move || {
            if let Err(error) = monitor_desktop(&monitor) {
                // Failure bias: keep enforcing if the optimization cannot be
                // installed, rather than suspending forever without notifications.
                log::warn!("uia_web_automation: activity notifications unavailable: {error}");
            }
            monitor.update(|state| *state = Activity::default());
        });
    });
    gate.clone()
}

fn monitor_desktop(gate: &Gate) -> windows::core::Result<()> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = w!("DigitalHabitsUiaActivity");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err(windows::core::Error::from_win32());
        }
        // A hidden top-level window receives session and power notifications.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        let power = match RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &GUID_SESSION_DISPLAY_STATUS,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        ) {
            Ok(handle) => handle,
            Err(error) => {
                let _ = DestroyWindow(hwnd);
                return Err(error);
            }
        };
        if let Err(error) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            let _ = UnregisterPowerSettingNotification(power);
            let _ = DestroyWindow(hwnd);
            return Err(error);
        }
        // Seed lock state: the app can start in an already locked session.
        let mut buffer = PWSTR::null();
        let mut bytes = 0;
        if WTSQuerySessionInformationW(
            None,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
        .is_ok()
        {
            if !buffer.is_null() && bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
                let info = &*buffer.0.cast::<WTSINFOEXW>();
                if info.Level == 1 {
                    let session = info.Data.WTSInfoExLevel1;
                    gate.update(|state| {
                        state.locked = session.SessionFlags == 0; // Windows 10+: LOCK=0
                        state.disconnected = session.SessionState == WTSDisconnected;
                    });
                }
            }
            WTSFreeMemory(buffer.0.cast());
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = WTSUnRegisterSessionNotification(hwnd);
        let _ = UnregisterPowerSettingNotification(power);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(class, Some(instance.into()));
        Ok(())
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if let Some(gate) = GATE.get() {
        if message == WM_WTSSESSION_CHANGE {
            gate.update(|state| match w.0 as u32 {
                WTS_SESSION_LOCK => state.locked = true,
                WTS_SESSION_UNLOCK => state.locked = false,
                WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT => state.disconnected = true,
                WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT => state.disconnected = false,
                _ => {}
            });
        } else if message == WM_POWERBROADCAST && w.0 as u32 == PBT_POWERSETTINGCHANGE && l.0 != 0 {
            let setting = unsafe { &*(l.0 as *const POWERBROADCAST_SETTING) };
            if setting.PowerSetting == GUID_SESSION_DISPLAY_STATUS && setting.DataLength == 4 {
                let status =
                    unsafe { std::ptr::read_unaligned(setting.Data.as_ptr().cast::<u32>()) };
                if status <= 2 {
                    // Dimmed (2) is still interactive, off (0) is not.
                    gate.update(|state| state.display_off = status == 0);
                }
            }
            return LRESULT(1);
        }
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn window_notifications_keep_lock_and_display_state_independent() {
        // Feed the real callback synthetic messages; never lock the user's PC.
        let gate = GATE.get_or_init(|| Arc::new(Gate::default()));
        gate.update(|state| *state = Activity::default());
        #[repr(C)]
        struct DisplayMessage {
            guid: windows::core::GUID,
            length: u32,
            status: u32,
        }
        let mut display = DisplayMessage {
            guid: GUID_SESSION_DISPLAY_STATUS,
            length: 4,
            status: 0,
        };
        let send_display = |display: &DisplayMessage| unsafe {
            window_proc(
                HWND::default(),
                WM_POWERBROADCAST,
                WPARAM(PBT_POWERSETTINGCHANGE as usize),
                LPARAM(display as *const _ as isize),
            );
        };
        unsafe {
            window_proc(
                HWND::default(),
                WM_WTSSESSION_CHANGE,
                WPARAM(WTS_SESSION_LOCK as usize),
                LPARAM(0),
            );
        }
        send_display(&display);
        unsafe {
            window_proc(
                HWND::default(),
                WM_WTSSESSION_CHANGE,
                WPARAM(WTS_SESSION_UNLOCK as usize),
                LPARAM(0),
            );
        }
        assert!(gate.suspended());
        display.status = 2; // Dimming is not screen-off.
        send_display(&display);
        assert!(!gate.suspended());
    }

    #[test]
    fn suspended_worker_waits_until_both_lock_and_screen_clear() {
        let gate = Arc::new(Gate::default());
        gate.update(|state| {
            state.locked = true;
            state.display_off = true;
        });
        let (tx, rx) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            worker_gate.wait_for_tick(Duration::from_millis(5));
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        gate.update(|state| state.locked = false);
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        gate.update(|state| state.display_off = false);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }
}
