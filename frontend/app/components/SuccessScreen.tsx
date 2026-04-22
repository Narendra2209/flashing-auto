interface Props {
  soNumber: string;
  onNew: () => void;
}

export default function SuccessScreen({ soNumber, onNew }: Props) {
  return (
    <div className="success-center">
      <div className="success-icon">✓</div>
      <h2>Order Created in MYOB!</h2>
      <p>The sales order has been submitted successfully and is now on hold pending sticker label.</p>
      <div className="so-number">
        <label>Sales Order Number</label>
        <span>{soNumber}</span>
      </div>
      <br />
      <button className="btn-new" onClick={onNew}>
        + Process New Order
      </button>
    </div>
  );
}
