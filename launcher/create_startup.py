'''BlackStack CRM V2 — Create Windows Startup Shortcut for the Launcher'''

import os
import sys

# The batch file that starts the CRM launcher
batch_path = r'D:\Work\Projects\blackstack\CB CRM V2\blackstack-crm-v2\start-launcher.bat'

# Windows Startup folder (current user)
startup_folder = os.path.join(os.environ['APPDATA'], r'Microsoft\Windows\Start Menu\Programs\Startup')
shortcut_path = os.path.join(startup_folder, 'BlackStack CRM Launcher.lnk')

# Create a VBS wrapper that launches the batch file hidden
vbs_path = os.path.join(startup_folder, 'BlackStack CRM Launcher.vbs')
vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c ""{batch_path}""", 0, False
'''

try:
    os.makedirs(startup_folder, exist_ok=True)
    with open(vbs_path, 'w') as f:
        f.write(vbs_content)
    print(f'Created VBS launcher: {vbs_path}')
    print(f'Target batch: {batch_path}')
    print(f'Startup folder: {startup_folder}')
    print()
    print('The launcher will now start automatically when Windows starts.')
    print('To remove: delete the file from the Startup folder.')
except Exception as e:
    print(f'Error: {e}')
    print(f'Please manually create a shortcut to:')
    print(f'  {batch_path}')
    print(f'In the Windows Startup folder:')
    print(f'  {startup_folder}')
