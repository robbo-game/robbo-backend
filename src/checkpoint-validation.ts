import { restoreAttempt, saveAttempt, type SavedAttempt } from '../vendor/robbo/src/application/saved-attempt';
import type { Pack } from '../vendor/robbo/src/engine/model';
export function validateCheckpoint(raw: unknown, packs: Pack[]): SavedAttempt {
  const session = restoreAttempt(raw,packs);
  // Round-trip through the engine to check entity references and normalize the format.
  session.world.assertConsistent();
  return saveAttempt(session, (raw as SavedAttempt).savedAt);
}
