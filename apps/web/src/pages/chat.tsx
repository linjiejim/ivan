import { lazy, Suspense } from "react";
import { useParams } from "react-router";
import { Spinner } from "../components/ui.tsx";

const ChatPanel = lazy(() =>
  import("../chat/chat-panel.tsx").then((m) => ({ default: m.ChatPanel })),
);

/** 全屏对话：窄屏上侧栏放不下时用；/chat/:threadId 直接打开某个会话 */
export function ChatPage() {
  const { threadId } = useParams();
  return (
    <div className="mx-auto h-[calc(100dvh-8rem)] max-w-3xl">
      <Suspense fallback={<Spinner />}>
        <ChatPanel full key={threadId ?? "current"} initialThread={threadId} />
      </Suspense>
    </div>
  );
}
