export type ProviderBrandId = string;

export function renderProviderBrandIcon(
  container: HTMLElement,
  providerId: ProviderBrandId
): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("data-provider-brand", providerId);
  container.append(svg);
  return svg;
}
