import Bull from "bull";
import { Game, GAME_TIME, GAMES, io, PLAYER_MAP, STATS, Stats } from "./server";
import { Chess } from "chess.js";
import dotenv from "dotenv";
dotenv.config();
const gameQueue = new Bull("game-queue", {
  redis:{
    host: 'redis-13067.c330.asia-south1-1.gce.redns.redis-cloud.com',
    port: 13067,
    password: 'tILQgdfjIVpjPPoWI7KnYfKHNkyyX6MA'
  }
});

gameQueue.empty().then(()=>{
  console.log("Game Queue Cleared!")
})
// Utility function to generate random ID
const getRandomId = async (length: number) => {
  let id = "";
  const letters =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  for (let i = 0; i < length; i++) {
    id += letters[Math.floor(Math.random() * letters.length)];
  }
  return id;
};

gameQueue.process(async (job: any) => {
  try {
    const waitingJobs = await gameQueue.getWaiting();
    const delayedJobs = await gameQueue.getDelayed();
    // console.log(waitingJobs, delayedJobs)
    const { playerId } = job.data;
    console.log("Matching ", playerId);
    const roomId = await getRandomId(9);

    if (waitingJobs.length >0 || delayedJobs.length>0) {
      const nextJob = waitingJobs[0];
      const { playerId: nextPlayerId } = nextJob.data;

      const newGame: Game = {
        gameId: roomId,
        players: [
          { socketId: PLAYER_MAP[playerId], color: "w", playerId:playerId},
          { socketId: PLAYER_MAP[nextPlayerId], color: "b" , playerId:nextPlayerId},
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
      console.log("Updated GAMES array:", GAMES, newGame.players); // Add logging here
      await nextJob.remove();
      console.log(
        `[GAME CREATED] between ${playerId} and ${nextPlayerId} with room ID ${roomId}`
      );


      if (PLAYER_MAP[playerId]) {
        io.to(PLAYER_MAP[playerId]).emit("game-created", {
          roomId,
          opponent: nextPlayerId,
        });
      }

      if (PLAYER_MAP[nextPlayerId]) {
        io.to(PLAYER_MAP[nextPlayerId]).emit("game-created", {
          roomId,
          opponent: playerId,
        });
      }

      const newStats:Stats = {online_players:STATS.online_players, games_in_progress:STATS.games_in_progress+1, matchmaking:STATS.matchmaking-2} 
      io.emit('update-stats', newStats)
    } else {
      console.log("No Players To Match.");
      // await gameQueue.add({ playerId }, { delay: 3000 });
      // await job.retry()
      gameQueue.add({playerId:playerId})
      await gameQueue.pause();
    }
  } catch (err) {
    console.log(err);
  }
});

gameQueue.on("failed", (job: any, err: any) => {
  console.log(`[JOB FAILED]: ${err}`);
});

// gameQueue.on("completed", (job: any) => {
//   console.log(`Job completed: ${job.id}`);
// });

gameQueue.on("error", (error: any) => {
  console.error("[REDIS ERROR]: ", error);
});

export { gameQueue };
