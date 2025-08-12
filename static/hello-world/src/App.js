import React, { useState } from 'react';
import ForgeUI, { render, Button, Text, useAction } from '@forge/ui';
import { invoke } from '@forge/bridge';

const App = () => {
  const [message, setMessage] = useState('');

  const onClick = async () => {
    const result = await invoke('generateReport');
    setMessage(result.message);
  };

  return (
    <div>
      <Button text="Generate Report" onClick={onClick} />
      {message && <Text>{message}</Text>}
    </div>
  );
};

export default App;

