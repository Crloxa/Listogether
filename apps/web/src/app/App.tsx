import { useRoute } from "./router";
import HomePage from "./HomePage";
import JoinPage from "../features/room/JoinPage";
import RoomPage from "../features/room/RoomPage";
import ThemeToggle from "../ui/ThemeToggle";

export default function App() {
  const route = useRoute();

  let page;
  if (route.path === "/join") {
    page = <JoinPage />;
  } else {
    const roomMatch = route.path.match(/^\/room\/([^/]+)$/);
    if (roomMatch?.[1]) {
      page = <RoomPage roomId={decodeURIComponent(roomMatch[1])} />;
    } else {
      page = <HomePage />;
    }
  }
  return (
    <>
      <ThemeToggle />
      {page}
    </>
  );
}
