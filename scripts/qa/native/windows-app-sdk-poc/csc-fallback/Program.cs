using System;
using System.IO;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

internal static class Program
{
    private static void Main()
    {
        try
        {
            var manager = AppNotificationManager.Default;
            manager.Register();
            var toast = new AppNotificationBuilder()
                .AddText("Shishi QA App SDK POC")
                .AddText("AUMID app.shishi.todo.qa")
                .AddButton(new AppNotificationButton("Open"))
                .BuildNotification();
            manager.Show(toast);
            Console.WriteLine("POC_SHOWN");
            System.Threading.Thread.Sleep(3000);
            manager.Unregister();
            Console.WriteLine("POC_COMPLETED");
        }
        catch (Exception error)
        {
            // WinRT exception ToString() can itself fail without the projection
            // runtime. Record type/HRESULT only; never print arguments/tokens.
            try
            {
                File.WriteAllText(
                    Path.Combine(AppContext.BaseDirectory, "poc-error.txt"),
                    error.GetType().FullName + " HRESULT=" + error.HResult
                );
            }
            catch { }
            Environment.ExitCode = 2;
        }
    }
}
