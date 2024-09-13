!macro customInstall
  WriteRegStr SHCTX "SOFTWARE\RegisteredApplications" "socrathink" "Software\Clients\StartMenuInternet\socrathink\Capabilities"

  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink" "" "socrathink HTML Document"
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\Application" "AppUserModelId" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\Application" "ApplicationIcon" "$INSTDIR\socrathink.exe,0"
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\Application" "ApplicationName" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\Application" "ApplicationCompany" "socrathink"      
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\Application" "ApplicationDescription" "Extensible, fast and innovative web browser with Innatical UI."      
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\DefaultIcon" "DefaultIcon" "$INSTDIR\socrathink.exe,0"
  WriteRegStr SHCTX "SOFTWARE\Classes\socrathink\shell\open\command" "" '"$INSTDIR\socrathink.exe" "%1"'

  WriteRegStr SHCTX "SOFTWARE\Classes\.htm\OpenWithProgIds" "socrathink" ""
  WriteRegStr SHCTX "SOFTWARE\Classes\.html\OpenWithProgIds" "socrathink" ""

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink" "" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\DefaultIcon" "" "$INSTDIR\socrathink.exe,0"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities" "ApplicationDescription" "Extensible, fast and innovative web browser with Innatical UI."
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities" "ApplicationName" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities" "ApplicationIcon" "$INSTDIR\socrathink.exe,0"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities\FileAssociations" ".htm" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities\FileAssociations" ".html" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities\URLAssociations" "http" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities\URLAssociations" "https" "socrathink"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\Capabilities\StartMenu" "StartMenuInternet" "socrathink"
  
  WriteRegDWORD SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\InstallInfo" "IconsVisible" 1
  
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink\shell\open\command" "" "$INSTDIR\socrathink.exe"
!macroend
!macro customUnInstall
  DeleteRegKey SHCTX "SOFTWARE\Classes\socrathink"
  DeleteRegKey SHCTX "SOFTWARE\Clients\StartMenuInternet\socrathink"
  DeleteRegValue SHCTX "SOFTWARE\RegisteredApplications" "socrathink"
!macroend