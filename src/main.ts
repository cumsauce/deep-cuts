import { defineCustomElement } from "vue";
import { addMainMenuEntry, definePluginContext } from "@ciderapp/pluginkit";
import Discover from "./pages/Discover.vue";
import PluginConfig from "./plugin.config";

export const CustomElements = {
  "page-discover": defineCustomElement(Discover, { shadowRoot: false }),
};

const { plugin, customElementName, goToPage } = definePluginContext({
  ...PluginConfig,
  CustomElements,
  setup() {
    for (const [key, value] of Object.entries(CustomElements)) {
      customElements.define(customElementName(key as keyof typeof CustomElements), value);
    }
    addMainMenuEntry({
      label: "Deep Cuts",
      onClick() {
        goToPage({ name: "page-discover" });
      },
    });
  },
});

export default plugin;
