import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { Chess } from "chess.js";
import { createClient } from "redis";
import { gameQueue } from "./creationQueue";

const app = express();
const server = http.createServer(app);

export const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000"], // Replace with your frontend URL
  },
});

// Socket ID is the player Id after all; just the name not changed yet
interface Player {
  socketId: string;
  playerId?: string;
  color: string;
  username?: string;
  image?: string;
}

export interface Game {
  gameId: string;
  game: Chess;
  players: Player[];
  moves: string[];
  turn: string;
  timestamps: {
    blackTime: number;
    whiteTime: number;
  };
}

export enum GAME_END_TYPE {
  "RESIGN",
  "DRAW",
  "STALEMATE",
  "CHECKMATE",
  "AUTO_DRAW",
}

export interface Stats {
  online_players: number;
  matchmaking: number;
  games_in_progress: number;
}

export let GAMES: Game[] = [];
export const GAME_TIME = 600; // 10 mins in secs
export const STATS: Stats = {
  online_players: 0,
  matchmaking: 0,
  games_in_progress: 0,
};

// Map for player to his
export const PLAYER_MAP: { [key: string]: string } = {};
export const PLAYER_DATA: { [key: string]: {} } = {};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.get("/", (req, res) => {
  res.send("Socket.IO server running");
});

// Create a new game room
app.post("/find-match", async (req, res) => {
  try {
    // Define the types separately if using TypeScript
    const body: { playerId: string } = req.body;

    // Log the incoming request for better debugging
    console.log(`[${new Date().toISOString()}] Received match request for player ID: ${body.playerId}`);
    
    // Add the player to the game queue
    const existingJobs = await gameQueue.getJobs(['waiting', 'active', 'delayed']);
    const jobExists = existingJobs.some(job => job.data.playerId === body.playerId);

    if (!jobExists) {
      await gameQueue.add({ playerId: body.playerId }, { delay: 1000 });
      console.log(`[${new Date().toISOString()}] Player ID ${body.playerId} added to the queue.`);
    } else {
      console.log(`[${new Date().toISOString()}] Player ID ${body.playerId} is already in the queue.`);
    }
    
    const isPaused = await gameQueue.isPaused();
    if (isPaused) {
      await gameQueue.resume();
      console.log(`[${new Date().toISOString()}] Resumed the game queue.`);
    }

    console.log("Jobs: ", await gameQueue.getJobCounts());

    // Update stats and emit to clients
    const newStats: Stats = {
      games_in_progress: STATS.games_in_progress,
      matchmaking: STATS.matchmaking + 1,
      online_players: STATS.online_players,
    };
    io.emit("update-stats", newStats);

    // Respond with success message
    res.status(200).json({ message: "Successfully added to queue!" });
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] [ERROR]: ${err.message}`); // Detailed error logging
    res.status(500).json({ message: "Error on server, try again!" });
  }
});

app.get("/replay/:id", async (req, res) => {
  const gameId = req.params.id;
  console.log("[REPLAY] ROOM:" + gameId);
  const game = GAMES.find((game: Game) => game.gameId == gameId);

  if (game) {
    res.status(200).json({ message: "SUCCESS", moves: game?.moves });
  } else {
    res.status(500).json({ message: "GAME NOT EXIST" });
  }
});

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  STATS.online_players += 1;

  // Map the data
  socket.on("map-data", (data: { playerId: string; user: {} }) => {
    PLAYER_MAP[data.playerId] = socket.id;
    PLAYER_DATA[socket.id] = data.user;
    console.log(`Player ${data.playerId} registered with socket ID ${socket.id}`);
    console.log(PLAYER_MAP);
    io.emit("update-stats", {
      online_players: STATS.online_players,
      matchmaking: STATS.matchmaking,
      games_in_progress: STATS.games_in_progress,
    });
  });

  // Handle room join event
  socket.on("join-room", (data: { gameID: string }) => {
    console.log(`[JOIN REQUEST] ROOMID: ${data.gameID}`);
    const game: Game = GAMES.find((game: Game) => game.gameId == data.gameID) as Game;
    console.log(game.players);
    socket.join(game.gameId);

    // Fire back the welcome event
    socket.emit("handshake-done", {
      color: game.players.find((player: Player) => player.socketId == socket.id)?.color,
      position: game?.game.fen(),
    });
  });

  // GAME EVENTS
  // Make move
  socket.on("make-move", (data: { roomId: string; from: string; to: string; color: string; time: number; }) => {
    console.log(data);
    try {
      const game = GAMES.find((game: Game) => game.gameId == data.roomId);
      if (data.color != game?.game.turn()) {
        return;
      }

      // Push the last fen to the moves array to be used for replay.
      game.moves.push(game.game.fen());

      const move = game?.game.move({ from: data.from, to: data.to });

      if (move != null) {
        const newFEN = game?.game.fen();

        // Set the timestamps you got from the player
        if (game && game.timestamps) {
          if (data.color == "w") {
            game.timestamps.whiteTime = data.time;
          } else {
            game.timestamps.blackTime = data.time;
          }
        }

        // Check for game end conditions
        if (game.game.isCheckmate()) {
          io.to(data.roomId).emit("game-over", { result: GAME_END_TYPE.CHECKMATE, winner: data.color });
        } else if (game?.game.isStalemate()) {
          io.to(data.roomId).emit("game-over", { result: GAME_END_TYPE.STALEMATE });
        } else if (game?.game.isDraw()) {
          io.to(data.roomId).emit("game-over", { result: GAME_END_TYPE.AUTO_DRAW });
        } else {
          io.to(data.roomId).emit("position-change", { newFEN, time: game?.timestamps });
        }
      } else {
        socket.emit("invalid-move");
      }
    } catch (err) {
      console.log(err);
    }
  });

  // Game start
  socket.on("start-game", (data: { gameId: string }) => {
    io.to(data.gameId).emit("game-started");
  });

  // Resign event for the game
  socket.on("resign", (data: { gameId: string; playerColor: string }) => {
    console.log(`[REMOVING GAME] GAME ${data.gameId} REMOVED!`);
    io.to(data.gameId).emit("alert", { type: GAME_END_TYPE.RESIGN });
  });

  // Draw
  socket.on("draw", (data: { gameId: string; playerColor: string }) => {
    const game = GAMES.find((game: Game) => game.gameId == data.gameId);
    const playerToAsk = game?.players.find((player: Player) => player.socketId != socket.id)?.socketId as string;
    io.to(playerToAsk).emit("alert", { type: GAME_END_TYPE.DRAW });
    socket.on("draw-answer", (data: { answer: boolean }) => {
      console.log(data);
      io.to(socket.id).emit("draw-response", data);
    });
  });

  // Handle player disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    STATS.online_players -= 1;
    io.emit("update-stats", {
      online_players: STATS.online_players,
      matchmaking: STATS.matchmaking,
      games_in_progress: STATS.games_in_progress,
    });

    const game: Game | undefined = GAMES.find((game: Game) =>
      game.players?.some((player: Player) => player.socketId === socket.id)
    );

    if (game) {
      game.players = game.players.filter((player: Player) => player.socketId !== socket.id);
      console.log(`Player with socket ID ${socket.id} removed from game ${game.gameId}`);

      if (game.players?.length === 0) {
        console.log(`No players left in game ${game.gameId}. Game is stopping.`);
        console.log(GAMES);
      }
    } else {
      console.log(`Game for socket ID ${socket.id} not found.`);
    }
  });
});

// Start the server
const PORT =  4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
