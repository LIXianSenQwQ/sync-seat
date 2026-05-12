import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";
import PickerView from "./views/PickerView.vue";
import RoomView from "./views/RoomView.vue";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/picker", component: PickerView },
    { path: "/room/:roomCode", component: RoomView }
  ]
});

createApp(App).use(router).mount("#app");
