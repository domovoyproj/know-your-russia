@rem Minimal gradlew.bat
@echo off
set DIRNAME=%~dp0
if "%DIRNAME%" == "" set DIRNAME=.
set APP_HOME=%DIRNAME%
set CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar

if exist "%CLASSPATH%" (
    java -jar "%CLASSPATH%" %*
) else (
    where gradle >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        gradle %*
    ) else (
        echo Gradle wrapper jar not found. Please install Gradle.
        exit /b 1
    )
)
