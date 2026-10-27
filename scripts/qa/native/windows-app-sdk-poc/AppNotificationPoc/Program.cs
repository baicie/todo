using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct PackageVersion
    {
        public ushort Major;
        public ushort Minor;
        public ushort Build;
        public ushort Revision;
    }

    [DllImport("Microsoft.WindowsAppRuntime.Bootstrap.dll", CharSet = CharSet.Unicode)]
    private static extern int MddBootstrapInitialize2(
        uint majorMinorVersion,
        string? versionTag,
        PackageVersion minVersion,
        uint options);

    [DllImport("Microsoft.WindowsAppRuntime.Bootstrap.dll")]
    private static extern void MddBootstrapShutdown();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    private static readonly string LogPath =
        Path.Combine(AppContext.BaseDirectory, "poc-log.txt");

    private static void Log(string message) =>
        File.AppendAllText(LogPath, DateTimeOffset.UtcNow.ToString("o") + " " + message + Environment.NewLine);

    private static void Main()
    {
        try
        {
            Log("start");
            var aumidHr = SetCurrentProcessExplicitAppUserModelID("app.shishi.todo.qa.poc");
            Log("aumid_hr=" + aumidHr);
#if !POC_NO_BOOTSTRAP
            var bootstrapHr = MddBootstrapInitialize2(0x00010008, null, new PackageVersion(), 0);
            Log("bootstrap_hr=" + bootstrapHr);
            if (bootstrapHr < 0)
            {
                Console.WriteLine("POC_STATUS=BOOTSTRAP_FAILED");
                Environment.ExitCode = 3;
                return;
            }
#else
            Log("bootstrap=skipped");
#endif
            Log("manager_supported=" + AppNotificationManager.IsSupported());
            Log("manager_default_begin");
            var manager = AppNotificationManager.Default;
            Log("manager_default_ok");
            // Subscribe before Register: activation can arrive immediately after
            // registration (including a cold-start activation from a previous run).
            manager.NotificationInvoked += (_, args) =>
            {
                Log("notification_invoked argument=" + args.Argument + " inputCount=" + args.UserInput.Count);
                Environment.ExitCode = 0;
            };
            Log("register_begin");
            manager.Register();
            Log("registered");
            var toast = new AppNotificationBuilder()
                .AddText("Shishi QA AppNotification POC")
                .AddText("unpackaged Windows App SDK")
                .AddArgument("source", "app-sdk-poc")
                .AddButton(new AppNotificationButton("Open")
                    .AddArgument("action", "open"))
                .BuildNotification();
            manager.Show(toast);
            Log("shown");
            Thread.Sleep(4000);
            manager.Unregister();
#if !POC_NO_BOOTSTRAP
            MddBootstrapShutdown();
#endif
            Log("unregistered");
            Console.WriteLine("POC_STATUS=REGISTERED_SHOWN_UNREGISTERED");
        }
        catch (Exception error)
        {
            try { Log("error type=" + error.GetType().FullName + " hr=" + error.HResult + " msg=" + error.Message); } catch { }
            Console.WriteLine("POC_STATUS=ERROR");
            Environment.ExitCode = 2;
        }
    }
}
