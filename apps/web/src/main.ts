import { createPinia } from "pinia";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";
import RoomView from "./views/RoomView.vue";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/room/:roomCode", component: RoomView }
  ]
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
