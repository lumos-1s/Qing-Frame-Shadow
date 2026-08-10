@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   QingFrameShadow Installer Builder
echo ============================================

echo [1/4] Building project (JDK 17)...
call mvn -q clean package
if errorlevel 1 goto :error

echo [2/4] Collecting dependencies...
call mvn -q dependency:copy-dependencies -DoutputDirectory=build\libs
if errorlevel 1 goto :error

echo [3/4] Copying main jar...
copy /y "target\QingFrameShadow-1.0.0.jar" "build\libs\" >nul
if errorlevel 1 goto :error

echo [4/4] Generating installer...
if not exist dist mkdir dist
jpackage --type exe --input build\libs --main-jar QingFrameShadow-1.0.0.jar --main-class com.qingframe.Main --name QingFrameShadow --app-version 1.0.0 --vendor QingFrame --dest dist --win-dir-chooser --win-shortcut --win-menu --java-options "--add-modules javafx.controls,javafx.fxml,javafx.swing"
if errorlevel 1 goto :error

echo.
echo Done! Installer: dist\QingFrameShadow-1.0.0.exe
echo.
pause
exit /b 0

:error
echo.
echo Build failed. Check the error above.
pause
exit /b 1
