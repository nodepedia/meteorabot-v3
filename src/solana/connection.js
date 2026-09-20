import { Connection } from "@solana/web3.js";
import config from "../config/index.js";

let _connection = null;

export function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
  }
  return _connection;
}
