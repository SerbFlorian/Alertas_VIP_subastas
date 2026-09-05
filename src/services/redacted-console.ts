import { redactSecrets } from './logger';

// ============================================================
// Redacta secretos también en console.* (fuera de Winston)
// ============================================================

let installed = false;

function wrap(
  original: (...args: unknown[]) => void
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const safe = args.map((a) => {
      if (typeof a === 'string') return redactSecrets(a);
      if (a instanceof Error) {
        const err = new Error(redactSecrets(a.message));
        err.name = a.name;
        err.stack = a.stack ? redactSecrets(a.stack) : a.stack;
        return err;
      }
      try {
        return JSON.parse(redactSecrets(JSON.stringify(a)));
      } catch {
        return redactSecrets(String(a));
      }
    });
    original.apply(console, safe);
  };
}

/** Idempotente: parchea log/info/warn/error/debug. */
export function installRedactedConsole(): void {
  if (installed) return;
  installed = true;

  console.log = wrap(console.log.bind(console));
  console.info = wrap(console.info.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
  console.debug = wrap(console.debug.bind(console));
}

// Side-effect: activo en cuanto se importa el módulo (antes de otros console.*)
installRedactedConsole();
