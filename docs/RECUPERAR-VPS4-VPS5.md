# Recuperar VPS4 y VPS5 — pasos exactos para el owner

**Diagnostico del 2026-09-08 18:00 UTC.** Todo lo de abajo se obtuvo en SOLO LECTURA:
Tailscale, un ping, un intento de SSH y los logs de GitHub Actions. No se ejecuto
ninguna accion de escritura sobre ninguna VPS.

## Estado medido

| VPS | Tailscale | SSH :22 | snapshot.json | Veredicto |
|---|---|---|---|---|
| vps1 | online | responde | escrito hoy 16:30 | sana |
| vps2 | online | responde | escrito hoy 16:30 | sana |
| vps3 | online | responde | escrito hoy 16:30 | sana (las 5 reales, stream en vivo OK) |
| **vps4** | **online, responde al ping (104 ms)** | **NO responde, timeout** | congelado hace **65,7 h** | **sshd caido** |
| **vps5** | **OFFLINE desde 2026-09-03 17:41 UTC** | inalcanzable | congelado hace **120,8 h** | **maquina apagada o sin red** |
| vps6 | online | responde | escrito hoy 16:30 | sana |

El watchdog de integridad lo confirma cada ciclo (issue #269):

```
- stale VPSs: vps4=3943.3min, vps5=7248.8min
- carry-forward too long: vps4 frozen 3943min (>180min - VPS never recovered)
- carry-forward too long: vps5 frozen 7249min (>180min - VPS never recovered)
- mcp-health critical: 2/6 VPS down (vps4, vps5)
```

El dashboard NO esta mintiendo: publica el banner "Datos parciales", marca las dos
VPS como caidas y hereda sus cifras marcandolas. Eso es lo correcto. Lo que no se
puede es tener el 100% del dato hasta que las dos maquinas vuelvan.

## VPS4 — la maquina vive, el servicio SSH no

Responde al ping de Tailscale, asi que Windows y Tailscale estan arrancados. Lo que
no acepta conexiones es OpenSSH. Como el acceso remoto que usa el pipeline es
justamente SSH, hay que entrar por **RDP** (el `#4 Package` en el panel de FXVM).

Una vez dentro, en PowerShell **como administrador**:

```powershell
Get-Service sshd                 # 1. ver en que estado esta
Start-Service sshd               # 2. arrancarlo
Set-Service sshd -StartupType Automatic   # 3. que sobreviva a un reinicio
Get-Service sshd                 # 4. confirmar Running
```

Si `Start-Service` falla, mirar por que antes de insistir:

```powershell
Get-EventLog -LogName Application -Source OpenSSH -Newest 20
Get-WinEvent -FilterHashtable @{LogName='OpenSSH/Operational'} -MaxEvents 20
```

Causa mas probable dado el historial de estas maquinas: memoria agotada. Comprobar
antes de reiniciar nada:

```powershell
Get-CimInstance Win32_OperatingSystem |
  Select @{n='FreeRAM_MB';e={[int]($_.FreePhysicalMemory/1KB)}},
         @{n='TotalRAM_MB';e={[int]($_.TotalVisibleMemorySize/1KB)}}
Get-Process | Sort WS -Desc | Select -First 10 Name, @{n='MB';e={[int]($_.WS/1MB)}}
```

Comprobar tambien que la tarea del builder sigue existiendo y con que resultado
termino la ultima vez:

```powershell
Get-ScheduledTask -TaskName BattleOfBots_Snapshot | Get-ScheduledTaskInfo
```

## VPS5 — la maquina esta apagada

Sin Tailscale y sin ping desde el 2026-09-03 17:41 UTC. No hay nada que reiniciar
por software: hay que **encenderla desde el panel de FXVM** (`#5 Package`) o pedir
soporte al proveedor si no arranca.

VPS5 es ademas la que dispara el CI cada 30 min (`dispatch_ci.ps1`). Eso **no** ha
roto el pipeline porque `refresh.yml` tiene su propio cron cada 15 min y ha corrido
con exito todo el dia. Es decir: la redundancia funciono.

Cuando vuelva, verificar en ella:

```powershell
Get-ScheduledTask -TaskName BattleOfBots_Snapshot | Get-ScheduledTaskInfo
Get-ScheduledTask | Where TaskName -like '*dispatch*' | Get-ScheduledTaskInfo
tailscale status
```

## Como saber que ya estan bien

Sin entrar en las maquinas, desde el Mac:

```bash
tailscale status | grep mt5vps          # las 6 sin "offline"
ssh -i ~/.ssh/id_ed25519_ci trader@<tailscale-ip-vps4> 'cmd /c echo OK'
```

Y en el dashboard, a los 15-45 min del siguiente ciclo completo:

- desaparece el banner "Datos parciales"
- la pildora de frescura baja de horas a minutos
- el modal MCP marca 6/6
- el workflow `integrity-watchdog` vuelve a verde y se cierra el issue #269

## Por que no lo arreglo yo

Regla permanente del proyecto: sobre las VPS solo leo. Diagnosticar, medir y
entregar los pasos, si; ejecutar acciones de escritura o reinicios, no, salvo orden
explicita para esa accion concreta. Ademas, en este caso concreto tampoco seria
posible: en vps4 el que esta caido es justamente el canal SSH por el que se
entraria, y vps5 no responde a nada.
