using System;
using System.IO;
using System.Windows.Forms;
using System.Diagnostics;
using System.Runtime.Versioning;
[assembly: TargetFramework(".NETFramework,Version=v4.8")]
class Probe {
    [STAThread]
    static void Main(string[] args) {
        string directory = args[0], identity = args[1];
        // A WinForms exception dialog disables the fixture while its timer can
        // keep pumping. Preserve the error and fail instead of a live false oracle.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs error) {
            File.WriteAllText(Path.Combine(directory, "fixture-error.txt"), error.Exception.ToString());
            Environment.Exit(1);
        };
        Application.EnableVisualStyles();
        var form = new Form { Text = identity, Width = 480, Height = 220 };
        var button = new Button { Text = "Save marker", Name = "save-marker", AccessibleName = "Save marker", Left = 130, Top = 65, Width = 220, Height = 44 };
        button.Click += delegate {
            var nonce = File.ReadAllText(Path.Combine(directory, "request"));
            File.WriteAllText(Path.Combine(directory, "gui-response"), nonce);
            File.WriteAllText(Path.Combine(directory, "saved-marker"), nonce);
        };
        form.Controls.Add(button);
        var timer = new Timer { Interval = 200 };
        timer.Tick += delegate {
            var request = Path.Combine(directory, "request");
            try {
                if (File.Exists(request)) File.WriteAllText(Path.Combine(directory, "response"), File.ReadAllText(request));
            } catch (IOException error) {
                // A writer/reader may briefly hold this protocol file. Only
                // sharing/lock violations defer to the next normal timer tick;
                // no response is fabricated and the client deadline is unchanged.
                int code = error.HResult & 0xffff;
                if (code != 32 && code != 33) throw;
                File.AppendAllText(Path.Combine(directory, "timer-sharing-retries.log"), DateTime.UtcNow.ToString("O") + " " + error.Message + Environment.NewLine);
            }
        };
        form.Shown += delegate { File.WriteAllText(Path.Combine(directory, "ready"), Process.GetCurrentProcess().Id.ToString()); timer.Start(); };
        form.FormClosing += delegate(object sender, FormClosingEventArgs close) {
            File.WriteAllText(Path.Combine(directory, "polite-quit"), DateTime.UtcNow.ToString("O"));
            if (args.Length > 2 && args[2] == "stubborn") close.Cancel = true;
        };
        Application.Run(form);
    }
}
