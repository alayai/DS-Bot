$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@PAYLOAD@@')) | ConvertFrom-Json
function Report($value) {
  [Console]::WriteLine($spec.marker + ($value | ConvertTo-Json -Compress))
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DshBenchJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint cb;
    public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h, int c, ref ExtendedLimits p, uint n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int c,out Accounting p,uint n,IntPtr written);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string dir,ref StartupInfo si,out ProcessInfo pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);

  public static IntPtr NewJob() {
    var job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception();
    var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
    if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) {
      var error=new Win32Exception(); CloseHandle(job); throw error;
    }
    return job;
  }
  static string Quote(string arg) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) {
      if(c=='\\') { slashes++; continue; }
      b.Append('\\', c=='"' ? slashes*2+1 : slashes); slashes=0; b.Append(c);
    }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  public static IntPtr Launch(IntPtr job,string exe,string[] args) {
    if(job==IntPtr.Zero) throw new InvalidOperationException("JOB_REQUIRED");
    var cmd=new StringBuilder(Quote(exe)); foreach(var a in args) cmd.Append(' ').Append(Quote(a));
    var si=new StartupInfo(); si.cb=(uint)Marshal.SizeOf(si); si.Flags=0x100;
    si.Stdout=GetStdHandle(-11); si.Stderr=GetStdHandle(-12);
    var input=CreateFile("NUL",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
    if(input==new IntPtr(-1)) throw new Win32Exception();
    ProcessInfo pi=new ProcessInfo(); bool resumed=false;
    try {
      si.Stdin=input;
      if(!SetHandleInformation(input,1,1) || !SetHandleInformation(si.Stdout,1,1) || !SetHandleInformation(si.Stderr,1,1)) throw new Win32Exception();
      if(!CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out pi)) throw new Win32Exception();
      // The returned process handle pins this exact process identity. Never reopen by PID.
      if(!AssignProcessToJobObject(job,pi.Process)) throw new Win32Exception(Marshal.GetLastWin32Error(),"JOB_ASSIGNMENT_FAILED");
      if(ResumeThread(pi.Thread)==0xFFFFFFFF) throw new Win32Exception();
      resumed=true;
      return pi.Process;
    } finally {
      CloseHandle(input);
      if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
      if(!resumed && pi.Process!=IntPtr.Zero) {
        TerminateProcess(pi.Process,1); WaitForSingleObject(pi.Process,5000); CloseHandle(pi.Process);
      }
    }
  }
  public static bool Exited(IntPtr process) {
    uint result=WaitForSingleObject(process,0);
    if(result==0xFFFFFFFF) throw new Win32Exception();
    return result==0;
  }
  public static uint ExitCode(IntPtr process) {
    uint code; if(!GetExitCodeProcess(process,out code)) throw new Win32Exception(); return code;
  }
  public static void Stop(IntPtr job) {
    if(!TerminateJobObject(job,1)) throw new Win32Exception();
    var deadline=Environment.TickCount;
    while(true) {
      Accounting data;
      if(!QueryInformationJobObject(job,1,out data,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception();
      if(data.ActiveProcesses==0) return;
      if(unchecked(Environment.TickCount-deadline)>5000) throw new TimeoutException("Job still contains live processes");
      Thread.Sleep(10);
    }
  }
  public static void Close(IntPtr handle) { if(handle!=IntPtr.Zero && !CloseHandle(handle)) throw new Win32Exception(); }
  public static Task<string> ReadStop() { return Task.Run(() => Console.ReadLine()); }
}
'@
$job = [IntPtr]::Zero
$targetHandle = [IntPtr]::Zero
$phase = 'startup'
try {
  $job = [DshBenchJob]::NewJob()
  $targetHandle = [DshBenchJob]::Launch($job, [string]$spec.executable, [string[]]$spec.args)
  $phase = 'running'
  Report @{kind='started'; jobAssigned=$true}
  $stopRequest = [DshBenchJob]::ReadStop()
  $reported = $false
  while (-not $stopRequest.IsCompleted) {
    if (-not $reported -and [DshBenchJob]::Exited($targetHandle)) {
      Report @{kind='done'; code=[DshBenchJob]::ExitCode($targetHandle); jobAssigned=$true}
      $reported = $true
    }
    Start-Sleep -Milliseconds 20
  }
  $phase = 'cleanup'
  [DshBenchJob]::Stop($job)
  Report @{kind='cleaned'}
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -in @(2,3)) { 'ENOENT' } else { 'JOB' }
  Report @{kind=$(if($phase -eq 'startup'){'done'}else{'cleanup-error'}); code=1; error=$code; detail=$cause.Message}
} finally {
  # Closing this handle also kills the job if the control channel fails.
  [DshBenchJob]::Close($job)
  [DshBenchJob]::Close($targetHandle)
}
