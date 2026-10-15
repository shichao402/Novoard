import { SafetyCertificateOutlined } from "@ant-design/icons";
import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

export function PublicCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="public-page">
      <Card className="public-card">
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space align="start">
            <SafetyCertificateOutlined style={{ fontSize: 28 }} />
            <div>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {title}
              </Typography.Title>
              <Typography.Text type="secondary">{subtitle}</Typography.Text>
            </div>
          </Space>
          {children}
        </Space>
      </Card>
    </main>
  );
}
