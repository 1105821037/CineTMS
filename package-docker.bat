@echo off
setlocal

set IMAGE=tms:latest
set OUTPUT=tms-latest.tar
set TMP_OUTPUT=%OUTPUT%.tmp
set BUILD_SEQUENCE_FILE=.tms\docker-build-sequence.txt
set DOCKER_BUILDKIT=1
set BUILD_TIME=
for /f %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\docker-build-sequence.ps1" -StateFile "%BUILD_SEQUENCE_FILE%"') do set BUILD_TIME=%%i
if not defined BUILD_TIME (
  echo Failed to generate Docker build time.
  exit /b 1
)
set BUILD_COMMIT=
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set BUILD_COMMIT=%%i

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
echo Build time: %BUILD_TIME%
if defined BUILD_COMMIT echo Commit: %BUILD_COMMIT%
docker build ^
  --build-arg BUILD_TIME=%BUILD_TIME% ^
  --build-arg RELEASE_CHANNEL=docker ^
  --build-arg BUILD_COMMIT=%BUILD_COMMIT% ^
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

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\docker-build-sequence.ps1" -StateFile "%BUILD_SEQUENCE_FILE%" -CommitBuildTime "%BUILD_TIME%"
if errorlevel 1 (
  echo Package created, but failed to save build sequence: %BUILD_TIME%
  exit /b 1
)

echo Done: %CD%\%OUTPUT%
