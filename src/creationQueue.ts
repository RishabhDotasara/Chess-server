import Bull from "bull";
import { Game, GAME_TIME, GAMES, io, PLAYER_MAP, STATS, Stats } from "./server";
import { Chess } from "chess.js";
import dotenv from "dotenv";

dotenv.config();

// "redis-13067.c330.asia-south1-1.gce.redns.redis-cloud.com"
// 13067,
// Create a new queue
const gameQueue = new Bull("gameQueue", {
  redis: {
    host: "redis-13067.c330.asia-south1-1.gce.redns.redis-cloud.com",
    port: 13067,
    password: "tILQgdfjIVpjPPoWI7KnYfKHNkyyX6MA",
  },
});

// Log any errors
gameQueue.on("error", (error) => {
  console.error("[REDIS ERROR]: ", error);
});

// Log when the queue is ready
gameQueue.on("ready", () => {
  console.log("Game Queue is ready.");
});

gameQueue.empty().then(()=>{
  console.log("Game Queue CLeared!")
})
// Process the queue
gameQueue.process(async (job) => {
  const { playerId } = job.data;
  console.log(`[START] Processing job for playerId: ${playerId}`);

  // Fetch waiting jobs and delayed jobs
  const waitingJobs = await gameQueue.getWaiting();
  const delayedJobs = await gameQueue.getDelayed();
  console.log(`Waiting jobs: ${waitingJobs.length}, Delayed jobs: ${delayedJobs.length}`);

  // Check if there are waiting jobs available
  if (waitingJobs.length > 0 || delayedJobs.length > 0) {
    // Pick the first waiting job
    const nextJob = waitingJobs.length>0 ?  waitingJobs[0] : delayedJobs[0];
    const { playerId: nextPlayerId } = nextJob.data;

    console.log(`[MATCH] Matching ${playerId} with ${nextPlayerId}`);
    
    // Prevent matching the same player
    if (playerId === nextPlayerId) {
      console.log(`[NO MATCH] Player cannot match with themselves: ${playerId}`);
      return; // Exit early if trying to match with oneself
    }

    const roomId = await getRandomId(9);
    const newGame: Game = {
      gameId: roomId,
      players: [
        { socketId: PLAYER_MAP[playerId], color: "w", playerId },
        { socketId: PLAYER_MAP[nextPlayerId], color: "b", playerId: nextPlayerId },
      ],
      game: new Chess(),
      moves: [],
      turn: "w",
      timestamps: {
        blackTime: GAME_TIME,
        whiteTime: GAME_TIME,
      },
    };

    GAMES.push(newGame);
    console.log(`[GAME CREATED] Game between ${playerId} and ${nextPlayerId}`);

    // Remove the matched job from the queue
    await nextJob.remove();
    console.log(`[REMOVE] Removed job for ${nextPlayerId}`);

    // Notify both players
    if (PLAYER_MAP[playerId]) {
      io.to(PLAYER_MAP[playerId]).emit("game-created", { roomId, opponent: nextPlayerId });
    }
    if (PLAYER_MAP[nextPlayerId]) {
      io.to(PLAYER_MAP[nextPlayerId]).emit("game-created", { roomId, opponent: playerId });
    }
  } else {
    console.log(`[NO MATCH] No players to match. Adding back to the queue.`);
    // Add player back to queue with a delay and without changing the priority
    await gameQueue.add({ playerId }, { delay: 3000 });
  }

  console.log(`[END] Finished processing for playerId: ${playerId}`);
});



// Utility function to generate a random ID
async function getRandomId(length: number): Promise<string> {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

export { gameQueue };
