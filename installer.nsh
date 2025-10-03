!macro customUnInstall
  nsExec::ExecToStack 'taskkill /IM "CFPL.exe" /F'
!macroend
