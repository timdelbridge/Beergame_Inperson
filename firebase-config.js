/**
 * Firebase project configuration.
 *
 * Shared with the Agribusiness-Sim tool (same "agribusiness-simulator"
 * project, different top-level Firestore collection: orderRoomSessions).
 * These values are public client identifiers, not secrets -- they are
 * meant to ship inside browser JS. Access control is enforced entirely by
 * firestore.rules, not by hiding this file.
 */

const firebaseConfig = {
  apiKey: "AIzaSyD10-r1lpU5m6N0jiXWuCP1ob6f9TJkWGE",
  authDomain: "agribusiness-simulator.firebaseapp.com",
  projectId: "agribusiness-simulator",
  storageBucket: "agribusiness-simulator.firebasestorage.app",
  messagingSenderId: "32731127314",
  appId: "1:32731127314:web:b766e9b706ac1d880202cb",
};

export { firebaseConfig };
