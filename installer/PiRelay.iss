#ifndef AppVersion
  #define AppVersion "1.7.13"
#endif
#ifndef ReleaseDir
  #define ReleaseDir "..\release-next"
#endif

[Setup]
#ifdef SmokeTest
AppId=PiRelay.InstallerSmoke
Uninstallable=no
CreateUninstallRegKey=no
#else
AppId={{E1463BD9-6FBD-4529-ACDB-6BA83BC7A4C2}
#endif
AppName=Pi Relay
AppVersion={#AppVersion}
AppPublisher=Pi Relay
DefaultDirName={localappdata}\Programs\Pi Relay
DefaultGroupName=Pi Relay
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\artifacts
#ifdef SmokeTest
OutputBaseFilename=PiRelay-Setup-Smoke
#else
OutputBaseFilename=PiRelay-Setup-{#AppVersion}-x64
#endif
SetupIconFile=..\native\Assets\PiRelay.ico
UninstallDisplayIcon={app}\release\PiRelay.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
#ifndef SmokeTest
AppMutex=Local\PiRelayDesktop
#endif
CloseApplications=no
RestartApplications=no
DisableProgramGroupPage=yes
UninstallDisplayName=Pi Relay
SetupLogging=yes

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Verknüpfung auf dem Desktop erstellen"; Flags: unchecked
#ifndef SmokeTest
Name: "viewer"; Description: "Portablen TigerVNC Viewer automatisch einrichten (Download)"; Check: IsFreshSetup
#endif

[Files]
Source: "{#ReleaseDir}\*"; DestDir: "{app}\release"; Excludes: "*.pdb,build-info.json"; Flags: ignoreversion recursesubdirs createallsubdirs

#ifndef SmokeTest
[Icons]
Name: "{userprograms}\Pi Relay"; Filename: "{app}\release\PiRelay.exe"; WorkingDir: "{app}\release"; IconFilename: "{app}\release\PiRelay.exe"; AppUserModelID: "PiRelay.Desktop"
Name: "{userdesktop}\Pi Relay"; Filename: "{app}\release\PiRelay.exe"; WorkingDir: "{app}\release"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\PiRelay.exe"; ValueType: string; ValueName: ""; ValueData: "{app}\release\PiRelay.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\PiRelay.exe"; ValueType: string; ValueName: "Path"; ValueData: "{app}\release"
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "PiRelay"; ValueData: """{app}\release\PiRelay.exe"""; Check: HasAutostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\release\PiRelay.exe"; Description: "Pi Relay öffnen"; WorkingDir: "{app}\release"; Flags: nowait postinstall skipifsilent
#endif

[Code]
function IsFreshSetup: Boolean;
begin
  Result := not FileExists(ExpandConstant('{localappdata}\PiRelay\settings.json')) and
    not FileExists(ExpandConstant('{app}\tools\vnc\viewer.json'));
end;

function HasAutostart: Boolean;
var Existing: String;
begin
  Result := RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'PiRelay', Existing) and (Existing <> '');
end;

procedure InitializeWizard;
var Page: TOutputMsgWizardPage; Found: TFindRec; Count: Integer; Folder, ProfileInfo: String;
begin
  Folder := AddBackslash(GetEnv('USERPROFILE')) + '.ssh';
  Count := 0;
  if FindFirst(Folder + '\*.pub', Found) then begin
    try
      repeat
        if (Found.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then Count := Count + 1;
      until not FindNext(Found);
    finally
      FindClose(Found);
    end;
  end;
  if FileExists(Folder + '\config') then ProfileInfo := 'Deine vorhandene SSH-Konfiguration wurde gefunden.'
  else ProfileInfo := 'SSH-Profile kannst du nach der Installation in Pi Relay einrichten.';
  Page := CreateOutputMsgPage(wpSelectDir, 'Deine SSH-Zugänge', 'Vorhandene Schlüssel weiterverwenden',
    ProfileInfo + #13#10#13#10 + IntToStr(Count) + ' öffentliche Schlüssel gefunden in:' + #13#10 + Folder + #13#10#13#10 +
    'Pi Relay liest deine vorhandenen Profile und öffentlichen Schlüssel beim Start. Private Schlüssel und Hardware-Schlüssel bleiben an ihrem bisherigen Ort.' + #13#10#13#10 +
    'Einstellungen bleiben bei Updates erhalten. Bei einer neuen Einrichtung kann Setup den portablen TigerVNC Viewer optional herunterladen. Eigene Viewer sind über die erweiterten Optionen verfügbar. Microsoft Edge WebView2 und Windows OpenSSH werden benötigt.');
end;

#ifndef SmokeTest
procedure CurStepChanged(CurStep: TSetupStep);
var ExitCode: Integer; Success: Boolean;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('viewer') then begin
    WizardForm.StatusLabel.Caption := 'Portablen Viewer herunterladen und prüfen ...';
    Success := Exec(ExpandConstant('{app}\release\PiRelay.exe'), '--viewer-install',
      ExpandConstant('{app}\release'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
    if (not Success) or (ExitCode <> 0) then begin
      Log('Automatische Viewer-Einrichtung fehlgeschlagen; Pi Relay bleibt installiert.');
      if not WizardSilent then MsgBox('Pi Relay wurde installiert. Der Viewer konnte noch nicht eingerichtet werden. Du kannst die Einrichtung später im Pi-Bildschirm-Menü erneut starten.', mbInformation, MB_OK);
    end;
  end;
end;
#endif
