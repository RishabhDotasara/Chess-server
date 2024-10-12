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
    origin: ["http://localhost:3000", "https://chess-iota-taupe.vercel.app/"], // Replace with your frontend URL
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true,
  },
});



//sokcetID is the player Id after all, just name not changes yet
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
export const GAME_TIME = 600; //10 mins in secs
export const STATS: Stats = {
  online_players: 0,
  matchmaking: 0,
  games_in_progress: 0,
};
//map for player to his
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
    //these typese need to be defined separately.
    const body: { playerId: string } = req.body;
    // console.log(body);
    await gameQueue.add({
      playerId: body.playerId,
    });

    const isPaused = await gameQueue.isPaused();
    if (isPaused) {
      gameQueue.resume();
    }

    const newStats: Stats = {
      games_in_progress: STATS.games_in_progress,
      matchmaking: STATS.matchmaking + 1,
      online_players: STATS.online_players,
    };
    io.emit("update-stats", newStats);

    res.status(200).json({ message: "Successfully added to queue!" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error On Server, Try Again!" });
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

  //map the data
  socket.on("map-data", (data: { playerId: string; user: {} }) => {
    PLAYER_MAP[data.playerId] = socket.id;
    PLAYER_DATA[socket.id] = data.user;
    console.log(
      `Player ${data.playerId} registered with socket ID ${socket.id}`
    );
    console.log(PLAYER_MAP);
    io.emit("update-stats", {
      online_players: STATS.online_players,
      matchmaking: STATS.matchmaking,
      games_in_progress: STATS.games_in_progress,
    });
  });

  //handle room join event
  socket.on("join-room", (data: { gameID: string }) => {
    console.log(`[JOIN REQUEST] ROOMID: ${data.gameID}`);
    const game: Game = GAMES.find(
      (game: Game) => game.gameId == data.gameID
    ) as Game;
    console.log(game.players);
    socket.join(game.gameId);

    //fire back the welcome event
    socket.emit("handshake-done", {
      color: game.players.find((player: Player) => player.socketId == socket.id)
        ?.color,
      position: game?.game.fen(),
    });
  });

  // GAME EVENTS
  //make move
  socket.on(
    "make-move",
    (data: {
      roomId: string;
      from: string;
      to: string;
      color: string;
      time: number;
    }) => {
      console.log(data);
      try {
        const game = GAMES.find((game: Game) => game.gameId == data.roomId);
        if (data.color != game?.game.turn()) {
          return;
        }

        //push the last fen to the moves array to be used for replay.
        game.moves.push(game.game.fen());

        const move = game?.game.move({
          from: data.from,
          to: data.to,
        });

        if (move != null) {
          const newFEN = game?.game.fen();

          //set the timestamps you got from the player
          if (game && game.timestamps) {
            if (data.color == "w") {
              game.timestamps.whiteTime = data.time;
            } else {
              game.timestamps.blackTime = data.time;
            }
          }

          // Check for game end conditions
          if (game.game.isCheckmate()) {
            io.to(data.roomId).emit("game-over", {
              result: GAME_END_TYPE.CHECKMATE,
              winner: data.color,
            });
          } else if (game?.game.isStalemate()) {
            io.to(data.roomId).emit("game-over", {
              result: GAME_END_TYPE.STALEMATE,
            });
          } else if (game?.game.isDraw()) {
            io.to(data.roomId).emit("game-over", {
              result: GAME_END_TYPE.AUTO_DRAW,
            });
          } else {
            io.to(data.roomId).emit("position-change", {
              newFEN,
              time: game?.timestamps,
            });
          }
        } else {
          socket.emit("invalid-move");
        }
      } catch (err) {
        console.log(err);
      }
    }
  );

  //game-start
  socket.on("start-game", (data: { gameId: string }) => {
    io.to(data.gameId).emit("game-started");
  });

  //resign event for the game
  socket.on("resign", (data: { gameId: string; playerColor: string }) => {
    console.log(`[REMOVING GAME] GAME ${data.gameId} REMOVED!`);
    io.to(data.gameId).emit("alert", { type: GAME_END_TYPE.RESIGN });
  });

  //draw
  socket.on("draw", (data: { gameId: string; playerColor: string }) => {
    const game = GAMES.find((game: Game) => game.gameId == data.gameId);
    const playerToAsk = game?.players.find(
      (player: Player) => player.socketId != socket.id
    )?.socketId as string;
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
      game.players = game.players.filter(
        (player: Player) => player.socketId !== socket.id
      );
      console.log(
        `Player with socket ID ${socket.id} removed from game ${game.gameId}`
      );

      if (game.players?.length === 0) {
        console.log(
          `No players left in game ${game.gameId}. Game is stopping.`
        );
        console.log(GAMES);
      }
    } else {
      console.log(`Game for socket ID ${socket.id} not found.`);
    }
  });
});

// Start the server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
