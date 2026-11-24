using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using NLog;
using NLog.Config;
using NLog.Targets;
using VRCX.Agent.Platform;

namespace VRCX.Agent;

internal static class Program
{
    private const string SingleInstanceMutexName = @"Local\VRCX.CloudAgent.SingleInstance";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out bool createdNew);
        if (!createdNew)
        {
            return;
        }

        ConfigureLogging();
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
    }

    private static void ConfigureLogging()
    {
        string logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VRCX-Agent",
            "logs");
        Directory.CreateDirectory(logDir);

        var config = new LoggingConfiguration();
        var fileTarget = new FileTarget("logfile")
        {
            FileName = Path.Combine(logDir, "agent.log"),
            ArchiveAboveSize = 2 * 1024 * 1024,
            MaxArchiveFiles = 3,
            Layout = "${longdate}|${level:uppercase=true}|${logger}|${message} ${exception:format=tostring}"
        };
        config.AddRule(LogLevel.Info, LogLevel.Fatal, fileTarget);
        LogManager.Configuration = config;
    }
}
