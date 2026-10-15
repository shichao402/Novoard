import { Button, Result } from "antd";
import { history } from "@/lib/navigation";

export default function NotFoundPage() {
  return (
    <Result
      status="404"
      title="页面不存在"
      extra={
        <Button type="primary" onClick={() => history.replace("/")}>
          返回控制台
        </Button>
      }
    />
  );
}
