@echo off
setlocal
REM One-click Phase 2 setup and walkthrough for Windows.
REM
REM It installs dependencies, downloads the browser the practice runs need, applies the database
REM migrations, runs the whole test suite, and then drives one complete practice application
REM against the bundled fake ATS.
REM
REM Everything stays on this machine. No employer site is contacted and nothing is submitted
REM anywhere. A transcript is written to phase-2-run.log next to this repository so the run can be
REM checked afterwards.

cd /d "%~dp0.."
set LOG=%CD%\phase-2-run.log

echo Phase 2 setup and walkthrough> "%LOG%"
echo Started %DATE% %TIME%>> "%LOG%"
echo.>> "%LOG%"

echo.
echo ============================================================
echo  Phase 2 setup and walkthrough
echo ============================================================
echo.
echo  Repository: %CD%
echo  Log file:   %LOG%
echo.
echo  This takes a few minutes. Nothing is sent to any employer.
echo.

call :step "Installing dependencies" "pnpm install --package-import-method=copy"
if errorlevel 1 goto :failed

call :step "Downloading the browser for practice runs" "pnpm browser:install"
if errorlevel 1 goto :failed

call :step "Applying database migrations" "pnpm db:migrate"
if errorlevel 1 goto :failed

call :step "Running the full test suite" "pnpm check"
if errorlevel 1 goto :failed

call :step "Running one complete practice application" "pnpm walkthrough:phase2"
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  Finished. The full transcript is in:
echo  %LOG%
echo ============================================================
echo.
echo Finished %DATE% %TIME%>> "%LOG%"
pause
exit /b 0

:step
echo.
echo ---- %~1 ...
echo.>> "%LOG%"
echo ==== %~1 ====>> "%LOG%"
call %~2 >> "%LOG%" 2>&1
if errorlevel 1 (
  echo      FAILED. See the log for the reason.
  echo ---- FAILED: %~1>> "%LOG%"
  exit /b 1
)
echo      done.
exit /b 0

:failed
echo.
echo ============================================================
echo  A step failed. Nothing was sent anywhere.
echo  The reason is at the end of:
echo  %LOG%
echo ============================================================
echo.
pause
exit /b 1
