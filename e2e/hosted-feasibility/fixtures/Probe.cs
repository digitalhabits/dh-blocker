using System;
using System.IO;
using System.Windows.Forms;
using System.Diagnostics;
class Probe {
    [STAThread]
    static void Main(string[] args) {
        string directory = args[0], identity = args[1];
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
            if (File.Exists(request)) File.WriteAllText(Path.Combine(directory, "response"), File.ReadAllText(request));
        };
        form.Shown += delegate { File.WriteAllText(Path.Combine(directory, "ready"), Process.GetCurrentProcess().Id.ToString()); timer.Start(); };
        form.FormClosing += delegate { File.WriteAllText(Path.Combine(directory, "polite-quit"), DateTime.UtcNow.ToString("O")); };
        Application.Run(form);
    }
}
