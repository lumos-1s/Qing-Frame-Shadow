@echo off
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot
set PATH=%JAVA_HOME%\bin;D:\Java\apache-maven-3.8.4\bin;%PATH%
cd /d "%~dp0"
echo Starting QingFrameShadow...
mvn javafx:run
pause