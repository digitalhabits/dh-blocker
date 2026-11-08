// External UIA client only. Never writes fixture state or sends window messages/keys.
#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;
void check(HRESULT hr) { if (FAILED(hr)) throw hr; }
std::string json(const wchar_t* text) {
    std::ostringstream out; out << '"';
    if (text) for (; *text; ++text) {
        unsigned c = *text;
        if (c == '"' || c == '\\') out << '\\' << char(c);
        else if (c >= 32 && c < 127) out << char(c);
        else { char b[7]; sprintf_s(b, "\\u%04x", c); out << b; }
    }
    out << '"'; return out.str();
}
std::string property(IUIAutomationElement* e, PROPERTYID id) {
    VARIANT v; VariantInit(&v); check(e->GetCurrentPropertyValue(id, &v));
    std::string result = v.vt == VT_BSTR ? json(v.bstrVal) : "null";
    VariantClear(&v); return result;
}
std::string describe(IUIAutomationElement* e) {
    int pid=0, type=0; UIA_HWND hwnd=nullptr; BOOL focusable=FALSE, enabled=FALSE;
    check(e->get_CurrentProcessId(&pid)); check(e->get_CurrentControlType(&type));
    check(e->get_CurrentNativeWindowHandle(&hwnd)); check(e->get_CurrentIsKeyboardFocusable(&focusable));
    check(e->get_CurrentIsEnabled(&enabled));
    std::ostringstream o;
    o << "{\"pid\":" << pid << ",\"hwnd\":" << reinterpret_cast<UINT_PTR>(hwnd)
      << ",\"controlType\":" << type << ",\"focusable\":" << (focusable ? "true" : "false")
      << ",\"enabled\":" << (enabled ? "true" : "false")
      << ",\"name\":" << property(e, UIA_NamePropertyId)
      << ",\"automationId\":" << property(e, UIA_AutomationIdPropertyId)
      << ",\"class\":" << property(e, UIA_ClassNamePropertyId)
      << ",\"provider\":" << property(e, UIA_ProviderDescriptionPropertyId) << ",\"patterns\":[";
    bool comma=false;
    for (int id=UIA_InvokePatternId; id<=UIA_CustomNavigationPatternId; ++id) {
        ComPtr<IUnknown> pattern;
        if (SUCCEEDED(e->GetCurrentPattern(id, &pattern)) && pattern) { if(comma) o << ','; o << id; comma=true; }
    }
    o << "]}"; return o.str();
}
struct Search { DWORD pid; std::wstring title; std::vector<HWND> windows; };
BOOL CALLBACK findWindow(HWND h, LPARAM l) {
    auto& s = *reinterpret_cast<Search*>(l); DWORD pid=0; GetWindowThreadProcessId(h,&pid);
    wchar_t title[512]; GetWindowTextW(h,title,512);
    if(pid==s.pid && s.title==title) s.windows.push_back(h);
    return TRUE;
}
int wmain(int argc, wchar_t** argv) {
    if(argc!=3) return 2;
    Search s{static_cast<DWORD>(wcstoul(argv[1],nullptr,10)),argv[2],{}};
    try {
        check(CoInitializeEx(nullptr,COINIT_MULTITHREADED));
        ComPtr<IUIAutomation> uia;
        check(CoCreateInstance(CLSID_CUIAutomation,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&uia)));
        EnumWindows(findWindow,reinterpret_cast<LPARAM>(&s));
        if(s.windows.size()!=1) throw E_INVALIDARG;
        ComPtr<IUIAutomationElement> window;
        check(uia->ElementFromHandle(s.windows[0],&window));
        ComPtr<IUIAutomationCondition> all; check(uia->CreateTrueCondition(&all));
        ComPtr<IUIAutomationElementArray> descendants;
        check(window->FindAll(TreeScope_Descendants,all.Get(),&descendants));
        int count=0; check(descendants->get_Length(&count));
        std::vector<ComPtr<IUIAutomationElement>> matches;
        std::ostringstream tree; tree << '[' << describe(window.Get());
        for(int i=0;i<count;++i) {
            ComPtr<IUIAutomationElement> e; check(descendants->GetElement(i,&e));
            tree << ',' << describe(e.Get());
            BSTR name=nullptr; check(e->get_CurrentName(&name));
            bool match=name && std::wstring(name)==L"Save marker"; SysFreeString(name);
            if(match) matches.push_back(e);
        }
        tree << ']';
        // Preserve the full native tree even when subsequent validation/Invoke fails.
        std::cerr << tree.str() << std::endl;
        if(matches.size()!=1) throw E_INVALIDARG;
        auto button=matches[0]; int pid=0,type=0; UIA_HWND hwnd=nullptr;
        check(button->get_CurrentProcessId(&pid)); check(button->get_CurrentControlType(&type));
        check(button->get_CurrentNativeWindowHandle(&hwnd));
        DWORD owner=0; GetWindowThreadProcessId(static_cast<HWND>(hwnd),&owner);
        if(pid!=static_cast<int>(s.pid) || owner!=s.pid || type!=UIA_ButtonControlTypeId || !IsChild(s.windows[0],static_cast<HWND>(hwnd))) throw E_ACCESSDENIED;
        if(property(button.Get(), UIA_AutomationIdPropertyId)!= "\"save-marker\"") throw E_INVALIDARG;
        ComPtr<IUIAutomationInvokePattern> invoke;
        check(button->GetCurrentPatternAs(UIA_InvokePatternId,IID_PPV_ARGS(&invoke)));
        if(!invoke) throw E_NOINTERFACE;
        check(invoke->Invoke());
        std::cout << "{\"method\":\"Native IUIAutomation InvokePattern\",\"pid\":" << s.pid << ",\"tree\":" << tree.str() << "}" << std::endl;
        return 0;
    } catch(HRESULT hr) {
        std::cerr << (hr==static_cast<HRESULT>(UIA_E_ELEMENTNOTENABLED) ? "Native fixture control disabled: HRESULT 0x" : "Native UIAutomation unavailable: HRESULT 0x")
                  << std::hex << static_cast<unsigned long>(hr) << std::endl;
        return 1;
    }
}

