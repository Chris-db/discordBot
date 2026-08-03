import { registerCommands } from '../handlers/commandHandler';

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
