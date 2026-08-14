@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM JavaFX 17 jmods 目录（下载 openjfx-17.0.2_windows-x64_bin-jmods.zip 后解压到这里）
set "JAVAFX_JMODS=D:\Java\javafx-jmods-17.0.2"

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
if not exist "%JAVAFX_JMODS%\javafx.base.jmod" (
    echo [ERROR] 找不到 JavaFX jmods：%JAVAFX_JMODS%
    echo 请先下载 openjfx-17.0.2_windows-x64_bin-jmods.zip 并解压到该目录后重试
    goto :error
)
jpackage --type exe --input build\libs --main-jar QingFrameShadow-1.0.0.jar --main-class com.qingframe.Main --name QingFrameShadow --app-version 1.0.0 --vendor QingFrame --dest dist --win-dir-chooser --win-shortcut --win-menu --module-path "%JAVAFX_JMODS%" --add-modules javafx.controls,javafx.fxml,javafx.swing
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
