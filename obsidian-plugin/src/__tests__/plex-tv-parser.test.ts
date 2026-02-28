import { describe, expect, it } from "vitest";
import { parsePlexResourcesXml } from "../core/plex-tv-parser";

describe("plex-tv-parser", () => {
  it("parseia resources e extrai servidores", () => {
    const xml = `
      <MediaContainer size="2">
        <Device name="Meu NAS" clientIdentifier="machine-1" provides="server,client" accessToken="srv-token" owned="1">
          <Connection uri="http://192.168.1.10:32400" local="1" protocol="http" address="192.168.1.10" port="32400" />
          <Connection uri="https://abc123.plex.direct:32400" local="0" protocol="https" address="abc123.plex.direct" port="32400" relay="0" />
        </Device>
        <Device name="Plex Web" clientIdentifier="web-1" provides="client" />
      </MediaContainer>
    `;

    const servers = parsePlexResourcesXml(xml);
    expect(servers).toHaveLength(2);

    expect(servers[0].machineId).toBe("machine-1");
    expect(servers[0].provides).toContain("server");
    expect(servers[0].connections).toHaveLength(2);
    expect(servers[0].connections[0].local).toBe(true);
  });
});
