"""kiz — nucleo canonico de Battle of Bots / Kiz Capital Command Center.

Creado 2026-09-08 como parte de la Fase 1-B del Blueprint. Existe para que
haya UNA sola definicion por metrica. Hoy conviven en el repositorio cuatro
Calmar, tres Sortino, cinco Sharpe y dos win-rate, y el archivo que se
autodenominaba fuente unica (`_metrics.py`) estaba practicamente muerto.

Regla de oro de este paquete: ninguna funcion de aqui puede depender del reloj
de pared. Toda ventana temporal se ancla a un timestamp que le pasa el
llamador (normalmente `snapshot.generated_at`), porque el gate de determinismo
de CI ejecuta el motor dos veces y exige bytes identicos.
"""

__all__ = ["metrics", "windows"]
__version__ = "1"
