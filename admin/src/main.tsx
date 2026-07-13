import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { adminBasePath } from "./api";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 3_000, retry: 1, refetchInterval: 30_000 } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter basename={adminBasePath}><App queryClient={queryClient} /></BrowserRouter></QueryClientProvider></React.StrictMode>
);
