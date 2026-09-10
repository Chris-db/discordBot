import { validateConfig } from '../config';
import { registerCommands } from '../handlers/commandHandler';

// registerCommands itself only warns when the token or client id is missing, and the
// script used to print "completed" over the top of that warning.
const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) console.error(`Config: ${problem}`);
  process.exit(1);
}

console.log('Registering Discord slash commands...');
registerCommands()
  .then(() => {
    console.log('Command registration script completed.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error during command registration:', err);
    process.exit(1);
  });
