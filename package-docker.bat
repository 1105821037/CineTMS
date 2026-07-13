@echo off
setlocal

set IMAGE=tms:latest
set OUTPUT=tms-latest.tar
set TMP_OUTPUT=%OUTPUT%.tmp
set DOCKER_BUILDKIT=1
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmm"') do set TMS_BUILD_TIME=%%i
set TMS_COMMIT=
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set TMS_COMMIT=%%i

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not available in PATH.
  exit /b 1
)

if not exist "Dockerfile" (
  echo Dockerfile not found.
  exit /b 1
)

if not exist "scripts\kdm-auto-download-ts\package-lock.json" (
  echo Missing scripts\kdm-auto-download-ts\package-lock.json.
  exit /b 1
)

if not exist "scripts\kdm-auto-download-ts\best.onnx" (
  echo Missing scripts\kdm-auto-download-ts\best.onnx.
  exit /b 1
)

if exist "%TMP_OUTPUT%" del /f "%TMP_OUTPUT%"
if exist "%OUTPUT%" (
  echo Removing old package: %OUTPUT%
  del /f "%OUTPUT%"
  if errorlevel 1 (
    echo Failed to remove old package: %OUTPUT%
    exit /b 1
  )
)

echo Building Docker image: %IMAGE%
echo Build time: %TMS_BUILD_TIME%
if defined TMS_COMMIT echo Commit: %TMS_COMMIT%
docker build ^
  --build-arg TMS_BUILD_TIME=%TMS_BUILD_TIME% ^
  --build-arg TMS_RELEASE_CHANNEL=docker ^
  --build-arg TMS_COMMIT=%TMS_COMMIT% ^
  -t %IMAGE% .
if errorlevel 1 (
  echo Docker build failed.
  exit /b 1
)

echo Image size:
docker image inspect %IMAGE% --format "{{.Size}} bytes"
if errorlevel 1 (
  echo Docker image inspect failed.
  exit /b 1
)

echo Saving Docker image to: %OUTPUT%
docker save -o "%TMP_OUTPUT%" %IMAGE%
if errorlevel 1 (
  echo Docker save failed.
  if exist "%TMP_OUTPUT%" del /f "%TMP_OUTPUT%"
  exit /b 1
)

move /y "%TMP_OUTPUT%" "%OUTPUT%" >nul
if errorlevel 1 (
  echo Failed to finalize package: %OUTPUT%
  exit /b 1
)

echo Done: %CD%\%OUTPUT%
