@echo off
if exist src\plugins (
  rmdir /s /q src\plugins
  echo Plugins directory removed
) else (
  echo No plugins directory found
)