; Explorer uses setup-package.ico. The installer GUI keeps its dark mark.
; This hook affects installation only; uninstall and installed app icons stay separate.
!define VOXLY_SETUP_GUI_ICON "${__FILEDIR__}\..\..\branding\tauri\icons\setup-dark.ico"
!define MUI_CUSTOMFUNCTION_GUIINIT VoxlySetupGUIInit

Var VoxlySetupLargeIcon
Var VoxlySetupSmallIcon

Function VoxlySetupGUIInit
  Push $0
  InitPluginsDir
  File "/oname=$PLUGINSDIR\voxly-setup-dark.ico" "${VOXLY_SETUP_GUI_ICON}"
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\voxly-setup-dark.ico", i 1, i 32, i 32, i 0x10) p.s'
  Pop $VoxlySetupLargeIcon
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\voxly-setup-dark.ico", i 1, i 16, i 16, i 0x10) p.s'
  Pop $VoxlySetupSmallIcon
  SendMessage $HWNDPARENT 0x80 1 $VoxlySetupLargeIcon ; WM_SETICON / ICON_BIG
  SendMessage $HWNDPARENT 0x80 0 $VoxlySetupSmallIcon ; WM_SETICON / ICON_SMALL
  GetDlgItem $0 $HWNDPARENT 1039
  SendMessage $0 0x170 0 $VoxlySetupLargeIcon ; STM_SETICON
  Pop $0
FunctionEnd

Function .onGUIEnd
  System::Call 'user32::DestroyIcon(p $VoxlySetupLargeIcon)'
  System::Call 'user32::DestroyIcon(p $VoxlySetupSmallIcon)'
FunctionEnd
