'use client';
import { useEffect, useState } from 'react';
import { read } from './data';
export function useCatalog<T>(url: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{key:string|null; data?:T; error?:string}>({key:null});
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({key:url});
    read<T>(url, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({key:url,data});
    }).catch(error => {
      if (!controller.signal.aborted) setState({key:url,error:error instanceof Error ? error.message : 'Нет соединения с сервером.'});
    });
    return () => controller.abort();
  }, [url,attempt]);
  const current: {data?:T; error?:string} = state.key === url ? state : {};
  return {...current, loading:!!url && !current.data && !current.error, retry:() => setAttempt(value => value+1)};
}
