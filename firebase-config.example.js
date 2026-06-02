// Copy this to firebase-config.js for local development.
// For production, the API key is injected by GitHub Actions.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY_HERE",
  authDomain: "boots-and-gloves.firebaseapp.com",
  databaseURL: "https://boots-and-gloves-default-rtdb.firebaseio.com",
  projectId: "boots-and-gloves",
  storageBucket: "boots-and-gloves.firebasestorage.app",
  messagingSenderId: "710609484147",
  appId: "1:710609484147:web:4c8d1cffac21d731d76d06"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
