/**
 * Barrel re-export for the queue system.
 *
 * The original monolithic queueService.ts (1,591 lines) has been split into
 * focused modules for maintainability:
 *
 *   queuePanel.ts         - Queue init, panel refresh, join/leave, admin/bot fills
 *   readyCheckService.ts  - 60-second AFK voice ready check phase
 *   votingService.ts      - Mode voting, captain verification, team verification, and captains draft
 *   queueTimeout.ts       - Periodic timeout sweeps and startup stuck-queue recovery
 *
 * All public exports are re-exported here so existing consumers (index.ts,
 * interactionHandler.ts, queue.ts, tests) continue to work with zero changes.
 */

// Queue Panel & Core Operations
export {
  getOrInitQueue,
  refreshQueuePanel,
  handleChannelMessage,
  handleJoinQueue,
  handleLeaveQueue,
  resetQueueAfterPop,
  fillQueueWithBots,
  forcePopQueue,
} from './queuePanel';

// Ready Check Phase
export { startReadyCheckPhase } from './readyCheckService';

// Voting & Drafting Phases
export {
  startVotingPhase,
  handleModeVote,
  finalizeVoteAndPop,
  startCaptainsVotePhase,
  handleCaptainsVote,
  finalizeCaptainsVote,
  startTeamsVotePhase,
  handleTeamsVote,
  finalizeTeamsVote,
  sendCaptainsDraftCard,
  handleCaptainPick,
} from './votingService';

// Timeouts & Recovery
export {
  checkQueueTimeouts,
  recoverStuckQueues,
} from './queueTimeout';
