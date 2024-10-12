import Bull from "bull";
import { Game, GAME_TIME, GAMES, io, PLAYER_MAP, STATS, Stats } from "./server";
import { Chess } from "chess.js";
import dotenv from "dotenv";

dotenv.config();

// Create a new queue
const gameQueue = new Bull("gameQueue", {
  redis: {
    host: "redis-13067.c330.asia-south1-1.gce.redns.redis-cloud.com",
    port: 13067,
    password:"tILQgdfjIVpjPPoWI7KnYfKHNkyyX6MA"
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

// Process the queue
gameQueue.process(async (job) => {
  try {
    const { playerId } = job.data;
    console.log("Matching ", playerId);
    
    // Fetch waiting jobs
    const waitingJobs = await gameQueue.getWaiting();
    const delayedJobs = await gameQueue.getDelayed();
    if (waitingJobs.length > 0 || delayedJobs.length>0) {
      const nextJob = waitingJobs.length > 0 ? waitingJobs[0] : delayedJobs[0];
      
      
      const { playerId: nextPlayerId } = nextJob.data;

      if (playerId == nextPlayerId) return
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
      console.log("Updated GAMES array:", GAMES);

      await nextJob.remove(); // Ensure the next job is removed from the queue
      console.log(`[GAME CREATED] between ${playerId} and ${nextPlayerId} with room ID ${roomId}`);

      // Notify both players
      if (PLAYER_MAP[playerId]) {
        io.to(PLAYER_MAP[playerId]).emit("game-created", { roomId, opponent: nextPlayerId });
      }
      if (PLAYER_MAP[nextPlayerId]) {
        io.to(PLAYER_MAP[nextPlayerId]).emit("game-created", { roomId, opponent: playerId });
      }

      // Update stats
      const newStats: Stats = {
        online_players: STATS.online_players,
        games_in_progress: STATS.games_in_progress + 1,
        matchmaking: STATS.matchmaking - 2,
      };
      io.emit('update-stats', newStats);
    } else {
      console.log("No Players To Match. Adding back to queue.");
      // Delay before re-adding to avoid a tight loop
      await gameQueue.add({ playerId }, { delay: 3000 });
      await gameQueue.pause()
    }
  } catch (err) {
    console.error("[JOB ERROR]: ", err);
  }
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
