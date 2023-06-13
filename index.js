// require express to create an express app
const express = require("express");
// require http module to create http server
const http = require("http");
// get Server class from socket.io to create socket.io server
const { Server } = require("socket.io");
// mongodb db
const { MongoClient, ServerApiVersion } = require("mongodb");
// allow cross origin resource sharing
const cors = require("cors");
// jsonwebtoken package for jwt token implementation
const jwt = require("jsonwebtoken");
// dot env package for .env file usage
require("dotenv").config();

// express app
const app = express();

// http server
const server = http.createServer(app);

// create socket.io server
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
  },
});

// PORT to run the server
const port = process.env.PORT || 5000;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@zitbo-1.8pinoyh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// middlewares
app.use(cors());
app.use(express.json());

// verify jwt token that comes from client side with http request
const verifyJWT = (req, res, next) => {
  const authorizationHeader = req.headers?.authorization;

  // if no authorization header then the request is unauthorized
  if (!authorizationHeader)
    return res.status(401).send({ message: "Unauthorized Access" });

  const token = authorizationHeader.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    // if err in verifying the token
    if (err) return res.status(403).send({ message: "Access Forbidden" });

    // if successful in verifying the token with the secret key
    req.decoded = decoded;
    // call the next handler of the route
    next();
  });
};

async function run() {
  try {
    // connect to db and get a message

    // connect the client to the server
    await client.connect();
    // send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("You successfully connected to MongoDB!");

    // database and collections
    const db = client.db("zitbo-1_db-1");
    const users = db.collection("users");

    // ********************

    //  REST APIs that uses req res model

    // ********************

    // validate username by checking if username is unique
    app.get("/users/validate/:username", async (req, res) => {
      const username = req.params.username;

      // check if user exists in db
      const userFromDB = await users.findOne({ username });

      // if user exists
      if (userFromDB) return res.send({ username: true });

      // if user doesn't exist
      return res.send({ username: false });
    });

    // create user in db after successful signup to firebase
    app.post("/users", async (req, res) => {
      const newUser = req.body;

      const result = await users.insertOne(newUser);

      res.send(result);
    });

    // get user after successful sign in to firebase with verified email
    app.get("/users/:username", verifyJWT, async (req, res) => {
      const username = req.params.username;

      // check if user exists in db
      const userFromDB = await users.findOne({ username });

      res.send(userFromDB);
    });

    // after first time authentication
    // send back a signed JSON payload aka JWT token to client for later authorization in server
    app.get("/jwt", async (req, res) => {
      const username = req.query.username;

      const userFromDB = await users.findOne({ username });

      // check that the requested user exists in my db
      if (userFromDB) {
        const token = jwt.sign({ username }, process.env.ACCESS_TOKEN_SECRET, {
          expiresIn: "7d",
        });
        return res.send({ token });
      }

      res.status(403).send({ token: "" });
    });

    // ********************

    //  socket.io server implementation for bidirectional event based realtime communication

    // ********************

    io.on("connection", (socket) => {
      console.log('New user connected...');
    })


  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to zitbo server!");
});

// listen to the port from http server
server.listen(port, () => {
  console.log(`Zitbo server is running in port ${port}`);
});
