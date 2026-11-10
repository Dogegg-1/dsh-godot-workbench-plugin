using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class GodotWindowsLpac {
    const int SecurityCapabilitiesAttribute = 0x20009;
    const int AllPackagesPolicyAttribute = 0x2000f;
    const int AllPackagesOptOut = 1;
    const uint ExtendedStartupInfoPresent = 0x00080000;
    const uint CreateNoWindow = 0x08000000;
    const uint CreateUnicodeEnvironment = 0x00000400;
    const uint CreateSuspended = 0x00000004;
    const uint KillOnJobClose = 0x2000;
    const uint LimitActiveProcesses = 0x00000008;
    const int JobExtendedLimitInformation = 9;
    const uint TokenQuery = 8;
    const int TokenIsAppContainer = 29;
    const uint WaitTimeout = 258;
    static void ValidateProfileName(string name) {
        if(name == null || !Regex.IsMatch(name, @"\Adsh\.godot\.run\.[0-9a-f]{32}\z")) throw new ArgumentException("Unexpected temporary profile name");
    }
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string n,string d,string x,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string n);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string n,out IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr old,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx info,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint exit);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct Capabilities {
        public IntPtr sid;
        public IntPtr caps;
        public uint count;
        public uint reserved;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        public uint cb;
        public string reserved,desktop,title;
        public uint x,y,xsize,ysize,xcount,ycount,fill,flags;
        public ushort show,reserved2;
        public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {
        public Startup info;
        public IntPtr attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process,thread;
        public uint pid,tid;
    }
    static void Check(bool value){
        if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileInformation info);
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;
        public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
    }
    public static void ValidateFile(string file){
        // PowerShell enumerates absolute paths. Win32 still needs the extended
        // local-path form when the sandbox's generated resources exceed MAX_PATH.
        if(file.Length>=260){
            if(!Regex.IsMatch(file, @"\A[A-Za-z]:\\") || Regex.IsMatch(file, @"\\\.{1,2}(?:\\|\z)"))
                throw new ArgumentException("Expected a normalized local sandbox path");
            file=@"\\?\"+file;
        }
        IntPtr handle=CreateFile(file,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
        Check(handle!=new IntPtr(-1));
        try{
            FileInformation info;
            Check(GetFileInformationByHandle(handle,out info));
            if(info.links!=1||(info.attributes&0x400)!=0)throw new Exception("Sandbox file is linked or reparsed");
        }
        finally{
            CloseHandle(handle);
        }
    }
    public static string Create(string name){
        ValidateProfileName(name);
        IntPtr sid=IntPtr.Zero,text=IntPtr.Zero;
        int hr=CreateAppContainerProfile(name,name,"Temporary Godot project boundary",IntPtr.Zero,0,out sid);
        Marshal.ThrowExceptionForHR(hr);
        bool ready=false;
        try{
            Check(ConvertSidToStringSid(sid,out text));
            string result=Marshal.PtrToStringUni(text);
            ready=true;
            return result;
        }
        finally{
            if(text!=IntPtr.Zero)LocalFree(text);
            if(sid!=IntPtr.Zero)FreeSid(sid);
            if(!ready)DeleteAppContainerProfile(name);
        }
    }
    public static void Delete(string name){
        ValidateProfileName(name);
        Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(name));
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime,jobTime;
        public uint flags;
        public UIntPtr minWorking,maxWorking;
        public uint active;
        public UIntPtr affinity;
        public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic;
        public IoCounters io;
        public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int size,out int returned);
    public class Result {
        public uint ExitCode;
        public uint ProcessId;
        public bool TimedOut;
        public bool IsAppContainer;
    }
    // Windows argv quoting: never interpret trusted arguments as shell code.
    static string Quote(string value){
        if(value==null||value.IndexOf('\0')>=0)throw new ArgumentException("Invalid argument");
        var text=new StringBuilder("\"");
        int slash=0;
        foreach(char c in value){
            if(c=='\\'){
                slash++;
                continue;
            }
            if(c=='\"'){
                text.Append('\\',slash*2+1);
                text.Append(c);
            }
            else{
                text.Append('\\',slash);
                text.Append(c);
            }
            slash=0;
        }
        text.Append('\\',slash*2);
        text.Append('\"');
        return text.ToString();
    }
    public static Result Run(string name,string exe,string directory,string[] arguments,uint timeout,bool windowCompatible=false){
        ValidateProfileName(name);
        IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,cap=IntPtr.Zero,policy=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;
        bool initialized=false,assigned=false;
        ProcessInfo process=new ProcessInfo();
        try {
            Marshal.ThrowExceptionForHR(DeriveAppContainerSidFromAppContainerName(name,out sid));
            IntPtr size=IntPtr.Zero;
            int attributeCount = windowCompatible ? 1 : 2;
            InitializeProcThreadAttributeList(IntPtr.Zero,attributeCount,0,ref size);
            if(size==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
            list=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list,attributeCount,0,ref size));
            initialized=true;
            var caps=new Capabilities{
                sid=sid,caps=IntPtr.Zero,count=0,reserved=0
            }
            ;
            cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));
            Marshal.StructureToPtr(caps,cap,false);
            Check(UpdateProcThreadAttribute(list,0,new IntPtr(SecurityCapabilitiesAttribute),cap,new IntPtr(Marshal.SizeOf(typeof(Capabilities))),IntPtr.Zero,IntPtr.Zero));
            // Standard AppContainer is an explicit host choice for windows, never
            // an automatic fallback. Both modes have zero named capabilities.
            if (!windowCompatible) {
                policy=Marshal.AllocHGlobal(4);
                Marshal.WriteInt32(policy,AllPackagesOptOut);
                Check(UpdateProcThreadAttribute(list,0,new IntPtr(AllPackagesPolicyAttribute),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero));
            }
            var info=new StartupEx();
            info.info.cb=(uint)Marshal.SizeOf(typeof(StartupEx));
            info.attributes=list;
            var command=new StringBuilder(Quote(exe));
            foreach(var arg in arguments)command.Append(" ").Append(Quote(arg));
            job=CreateJobObject(IntPtr.Zero,null);
            Check(job!=IntPtr.Zero);
            var limits=new ExtendedLimits();
            limits.basic.flags=KillOnJobClose | LimitActiveProcesses;
            limits.basic.active=1;
            // KILL_ON_JOB_CLOSE; no breakaway.
            Check(SetInformationJobObject(job,JobExtendedLimitInformation,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            var systemRoot=Environment.GetEnvironmentVariable("SystemRoot");
            env=Marshal.StringToHGlobalUni("APPDATA="+directory+"\0LOCALAPPDATA="+directory+"\0SystemRoot="+systemRoot+"\0TEMP="+directory+"\0TMP="+directory+"\0USERPROFILE="+directory+"\0\0");
            // A hard kill between creation and job assignment can strand a suspended process.
            // It has not executed project code; normal exception cleanup terminates it.
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,ExtendedStartupInfoPresent|CreateNoWindow|CreateUnicodeEnvironment|CreateSuspended,env,directory,ref info,out process));
            Check(AssignProcessToJobObject(job,process.process));
            assigned=true;
            IntPtr token=IntPtr.Zero;
            int appContainer=0,returned;
            try{
                Check(OpenProcessToken(process.process,TokenQuery,out token));
                Check(GetTokenInformation(token,TokenIsAppContainer,out appContainer,4,out returned));
                if(appContainer!=1)throw new Exception("Child token is not AppContainer");
            }
            finally{
                if(token!=IntPtr.Zero)CloseHandle(token);
            }
            if(ResumeThread(process.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
            uint wait=WaitForSingleObject(process.process,timeout);
            bool timedOut=wait==WaitTimeout;
            if(wait!=0){
                Check(TerminateJobObject(job,124));
                WaitForSingleObject(process.process,5000);
                if(!timedOut)throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            uint exit;
            Check(GetExitCodeProcess(process.process,out exit));
            return new Result{
                ExitCode=exit,ProcessId=process.pid,TimedOut=timedOut,IsAppContainer=appContainer==1
            }
            ;
        }
        finally {
            // Assignment failure must also terminate the never-resumed process.
            if(process.process!=IntPtr.Zero&&!assigned){
                TerminateProcess(process.process,125);
                WaitForSingleObject(process.process,5000);
            }
            if(job!=IntPtr.Zero)CloseHandle(job);
            if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
            if(process.process!=IntPtr.Zero)CloseHandle(process.process);
            if(initialized)DeleteProcThreadAttributeList(list);
            if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);
            if(cap!=IntPtr.Zero)Marshal.FreeHGlobal(cap);
            if(policy!=IntPtr.Zero)Marshal.FreeHGlobal(policy);
            if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
            if(sid!=IntPtr.Zero)FreeSid(sid);
        }
    }
}
