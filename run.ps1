$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot"
$env:Path = "$env:JAVA_HOME\bin;D:\Java\apache-maven-3.8.4\bin;$env:Path"
Set-Location $PSScriptRoot
Write-Host "Starting QingFrameShadow..."
mvn javafx:run
Read-Host "Press Enter to exit"
