; Installer hooks for Windows (NSIS). Tauri's template already registers the ProgId
; KitesMarkdown.Document for every Markdown extension (from bundle.fileAssociations). These hooks add
; what makes the app a proper choice in Windows' own default-app settings:
;   - OpenWithProgids for each extension, so the app is listed under "Open with";
;   - Capabilities + RegisteredApplications, so it is listed in Settings > Apps > Default apps;
;   - Applications\kites-markdown.exe, the name and types shown in the "Open with" dialog;
;   - a quoted open command (the template's leaves the program path unquoted, and the install folder
;     has a space in it).
; After an interactive install, Settings opens at the app's page: Windows lets only the person choose
; a default. A silent install (/S, used by CI) skips that.
; Everything is per user (SHCTX is HKCU for a currentUser install) and is removed on uninstall.

; This file is included before the template defines MAINBINARYNAME, so only constant defines live at
; the top; everything that names the program is inside the macros, which expand where they are used.
!define MDV_PROGID "KitesMarkdown.Document"
!define MDV_CAPABILITIES "Software\Kites Markdown\Capabilities"

!macro MDV_REGISTER_EXT EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${MDV_PROGID}" ""
  WriteRegStr SHCTX "${MDV_CAPABILITIES}\FileAssociations" ".${EXT}" "${MDV_PROGID}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro MDV_UNREGISTER_EXT EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${MDV_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  ; The template's APP_UNASSOCIATE restores the previous handler from this value but leaves it behind.
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${MDV_PROGID}_backup"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${MDV_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\${MDV_PROGID}" "FriendlyTypeName" "Markdown document"

  WriteRegStr SHCTX "${MDV_CAPABILITIES}" "ApplicationName" "Kites Markdown"
  WriteRegStr SHCTX "${MDV_CAPABILITIES}" "ApplicationDescription" "Read Markdown files with diagrams, math and code."
  WriteRegStr SHCTX "${MDV_CAPABILITIES}" "ApplicationIcon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\RegisteredApplications" "Kites Markdown" "${MDV_CAPABILITIES}"

  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Kites Markdown"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  !insertmacro MDV_REGISTER_EXT "md"
  !insertmacro MDV_REGISTER_EXT "markdown"
  !insertmacro MDV_REGISTER_EXT "mdown"
  !insertmacro MDV_REGISTER_EXT "mkd"
  !insertmacro MDV_REGISTER_EXT "mkdn"
  !insertmacro MDV_REGISTER_EXT "mdwn"
  !insertmacro MDV_REGISTER_EXT "mdtxt"
  !insertmacro MDV_REGISTER_EXT "mdtext"

  ; Tell Explorer the associations changed.
  !insertmacro UPDATEFILEASSOC

  ${IfNot} ${Silent}
  ${AndIfNot} $PassiveMode = 1
    ExecShell "open" "ms-settings:defaultapps?registeredAppUser=Kites%20Markdown"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MDV_UNREGISTER_EXT "md"
  !insertmacro MDV_UNREGISTER_EXT "markdown"
  !insertmacro MDV_UNREGISTER_EXT "mdown"
  !insertmacro MDV_UNREGISTER_EXT "mkd"
  !insertmacro MDV_UNREGISTER_EXT "mkdn"
  !insertmacro MDV_UNREGISTER_EXT "mdwn"
  !insertmacro MDV_UNREGISTER_EXT "mdtxt"
  !insertmacro MDV_UNREGISTER_EXT "mdtext"

  DeleteRegValue SHCTX "Software\RegisteredApplications" "Kites Markdown"
  DeleteRegKey SHCTX "${MDV_CAPABILITIES}"
  DeleteRegKey /ifempty SHCTX "Software\Kites Markdown"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"

  !insertmacro UPDATEFILEASSOC
!macroend
