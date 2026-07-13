@echo off
setlocal

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not available in PATH.
  exit /b 1
)

echo This will remove Docker build cache and dangling images.
echo Running containers and tagged images in use will not be removed.
echo.
set /p CONFIRM=Continue? Type YES to proceed: 
if /i not "%CONFIRM%"=="YES" (
  echo Canceled.
  exit /b 0
)

echo.
echo Docker disk usage before cleanup:
docker system df

echo.
echo Pruning Docker build cache...
docker builder prune -af
if errorlevel 1 (
  echo Docker builder prune failed.
  exit /b 1
)

echo.
echo Pruning dangling images...
docker image prune -f
if errorlevel 1 (
  echo Docker image prune failed.
  exit /b 1
)

echo.
echo Docker disk usage after cleanup:
docker system df

echo.
echo Done.
