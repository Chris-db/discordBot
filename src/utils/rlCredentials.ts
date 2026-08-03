import { isRlCredentialInUse } from '../database/queries';

/**
 * Generates a shorter, unique Rocket League 6mans lobby name (e.g. RL42) and 3-digit numeric password.
 */
export function generateRlCredentials(): { rlName: string; rlPass: string } {
  let rlName = '';
  let rlPass = '';
  let attempts = 0;

  do {
    const idRange = attempts < 30 ? Math.floor(10 + Math.random() * 90) : Math.floor(100 + Math.random() * 900);
    const randomPass = Math.floor(100 + Math.random() * 900).toString();
    rlName = `RL${idRange}`;
    rlPass = randomPass;
    attempts++;
  } while (isRlCredentialInUse(rlName, rlPass) && attempts < 50);

  return {
    rlName,
    rlPass,
  };
}
