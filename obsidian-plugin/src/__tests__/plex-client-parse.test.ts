import { describe, expect, it } from "vitest";
import { parseItemsXml, parseSectionsXml } from "../core/plex-xml-parser";

describe("plex-client parser", () => {
  it("parseia sections XML", () => {
    const xml = `
      <MediaContainer size="2">
        <Directory key="1" title="Filmes" type="movie" />
        <Directory key="2" title="Series" type="show" />
      </MediaContainer>
    `;

    const sections = parseSectionsXml(xml);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Filmes");
    expect(sections[1].type).toBe("show");
  });

  it("parseia itens XML (movie/show)", () => {
    const xml = `
      <MediaContainer size="2">
        <Video ratingKey="10" guid="g1" type="movie" title="Cidade de Deus" year="2002" viewCount="1" updatedAt="1700000100" />
        <Directory ratingKey="20" guid="g2" type="show" title="Dark" leafCount="26" viewedLeafCount="26" updatedAt="1700000200" />
      </MediaContainer>
    `;

    const items = parseItemsXml(xml, "Filmes");
    expect(items).toHaveLength(2);
    expect(items[0].ratingKey).toBe("10");
    expect(items[1].type).toBe("show");
    expect(items[1].leafCount).toBe(26);
  });
});
